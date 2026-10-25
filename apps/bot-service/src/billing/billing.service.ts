import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type Stripe from "stripe";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import {
  isPlanKey,
  planFor,
  type BillingCheckoutResult,
  type BillingInvoice,
  type BillingOverview,
  type BusinessContext,
  type PlanKey,
} from "@platform/shared-types";
import { billingConfigured, planForPrice, priceFor, stripe } from "./stripe";

const config = loadServiceConfig("bot-service", 3002);
const BILLING_PAGE = "/dashboard/settings/billing";
// A subscription in one of these is "current": switching plans updates it instead of starting a new checkout.
const CURRENT = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
const INVOICE_LIMIT = 12;

type AccountRow = NonNullable<Awaited<ReturnType<typeof prisma.billingAccount.findUnique>>>;

function stripeError(err: unknown): string {
  return (err as { message?: string })?.message ?? "Stripe request failed";
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  async overview(ctx: BusinessContext): Promise<BillingOverview> {
    const [business, account] = await Promise.all([
      prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId }, select: { plan: true } }),
      prisma.billingAccount.findUnique({ where: { businessId: ctx.businessId } }),
    ]);
    const canManage = ctx.permissions.includes("business:manage");
    return {
      configured: billingConfigured(),
      plan: planFor(business.plan).key,
      subscription:
        account?.stripeSubscriptionId && account.status
          ? {
              status: account.status,
              currentPeriodEnd: account.currentPeriodEnd?.toISOString(),
              cancelAtPeriodEnd: account.cancelAtPeriodEnd,
              ...(account.cardBrand && account.cardLast4 ? { card: { brand: account.cardBrand, last4: account.cardLast4 } } : {}),
            }
          : null,
      billingEmail: account?.billingEmail ?? undefined,
      invoices: canManage && account && billingConfigured() ? await this.invoices(account.stripeCustomerId) : [],
    };
  }

  /**
   * First subscription: returns a Stripe Checkout URL. With a current
   * subscription: switches its price (prorated) and returns the new overview.
   */
  async checkout(ctx: BusinessContext, plan: unknown): Promise<BillingCheckoutResult> {
    this.requireConfigured();
    if (!isPlanKey(plan)) throw new BadRequestException("plan must be starter, growth or pro");
    const account = await this.ensureCustomer(ctx);

    if (account.stripeSubscriptionId && account.status && CURRENT.has(account.status)) {
      await this.switchPlan(account, plan);
      return { overview: await this.overview(ctx) };
    }

    try {
      const session = await stripe().checkout.sessions.create({
        mode: "subscription",
        customer: account.stripeCustomerId,
        client_reference_id: ctx.businessId,
        line_items: [{ price: priceFor(plan), quantity: 1 }],
        subscription_data: { metadata: { businessId: ctx.businessId } },
        allow_promotion_codes: true,
        success_url: `${config.webAppUrl}${BILLING_PAGE}?checkout=success`,
        cancel_url: `${config.webAppUrl}${BILLING_PAGE}?checkout=cancelled`,
      });
      if (!session.url) throw new Error("Stripe didn't return a checkout URL");
      return { url: session.url };
    } catch (err) {
      throw new BadRequestException(`Couldn't start checkout: ${stripeError(err)}`);
    }
  }

  /** Stripe's hosted portal: card, billing details, invoices, cancelling. */
  async portal(ctx: BusinessContext): Promise<{ url: string }> {
    this.requireConfigured();
    const account = await prisma.billingAccount.findUnique({ where: { businessId: ctx.businessId } });
    if (!account) throw new BadRequestException("Choose a plan first. There's nothing to manage yet.");
    try {
      const session = await stripe().billingPortal.sessions.create({
        customer: account.stripeCustomerId,
        return_url: `${config.webAppUrl}${BILLING_PAGE}`,
      });
      return { url: session.url };
    } catch (err) {
      throw new BadRequestException(`Couldn't open the billing portal: ${stripeError(err)}`);
    }
  }

  /** Cancel at the end of the paid period (true), or undo that (false). */
  async setCancelAtPeriodEnd(ctx: BusinessContext, cancel: boolean): Promise<BillingOverview> {
    this.requireConfigured();
    const account = await prisma.billingAccount.findUnique({ where: { businessId: ctx.businessId } });
    if (!account?.stripeSubscriptionId || !account.status || !CURRENT.has(account.status)) {
      throw new BadRequestException("There's no active subscription");
    }
    try {
      const subscription = await stripe().subscriptions.update(account.stripeSubscriptionId, {
        cancel_at_period_end: cancel,
        expand: ["default_payment_method"],
      });
      await this.sync(subscription);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Stripe refused the change: ${stripeError(err)}`);
    }
    return this.overview(ctx);
  }

  // --- Webhook ----------------------------------------------------------------

  /** Verifies Stripe's signature over the raw body, then syncs the subscription it's about. */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !billingConfigured()) throw new ServiceUnavailableException("Billing isn't configured");
    if (!rawBody || !signature) throw new BadRequestException("Missing signature");
    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new BadRequestException("Bad signature");
    }

    const subscriptionId = this.subscriptionIdOf(event);
    if (subscriptionId) {
      // Fetch the current state rather than trusting the event: events can arrive out of order.
      const subscription = await stripe().subscriptions.retrieve(subscriptionId, { expand: ["default_payment_method"] });
      await this.sync(subscription);
    }
    return { received: true };
  }

  private subscriptionIdOf(event: Stripe.Event): string | null {
    const ref = (value: unknown) => (typeof value === "string" ? value : (value as { id?: string } | null)?.id ?? null);
    switch (event.type) {
      case "checkout.session.completed":
        return event.data.object.mode === "subscription" ? ref(event.data.object.subscription) : null;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        return event.data.object.id;
      case "invoice.paid":
      case "invoice.payment_failed":
        return ref(event.data.object.parent?.subscription_details?.subscription);
      default:
        return null;
    }
  }

  /** Copies a subscription onto the business's BillingAccount and sets Business.plan from its price. */
  private async sync(subscription: Stripe.Subscription) {
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    const account = await prisma.billingAccount.findUnique({ where: { stripeCustomerId: customerId } });
    if (!account) {
      this.logger.warn(`Stripe subscription ${subscription.id} for unknown customer ${customerId}`);
      return;
    }
    // A newer subscription replaced this one (e.g. re-subscribed after cancelling): ignore the old one's events.
    if (account.stripeSubscriptionId && account.stripeSubscriptionId !== subscription.id && subscription.status === "canceled") return;

    const item = subscription.items.data[0];
    const plan = planForPrice(item?.price.id);
    const card = await this.cardOf(subscription);
    await prisma.$transaction([
      prisma.billingAccount.update({
        where: { id: account.id },
        data: {
          stripeSubscriptionId: subscription.id,
          status: subscription.status,
          currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          ...(card ? { cardBrand: card.brand, cardLast4: card.last4 } : {}),
        },
      }),
      // An ended subscription drops to the smallest plan's limits.
      prisma.business.update({
        where: { id: account.businessId },
        data: { plan: subscription.status === "canceled" ? "starter" : plan ?? undefined },
      }),
    ]);
  }

  private async cardOf(subscription: Stripe.Subscription): Promise<{ brand: string; last4: string } | null> {
    let method = subscription.default_payment_method;
    if (!method || typeof method === "string") {
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const customer = await stripe().customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] });
      method = customer.deleted ? null : (customer.invoice_settings.default_payment_method as Stripe.PaymentMethod | string | null);
    }
    return method && typeof method !== "string" && method.card ? { brand: method.card.brand, last4: method.card.last4 } : null;
  }

  // --- Helpers -----------------------------------------------------------------

  private async switchPlan(account: AccountRow, plan: PlanKey) {
    try {
      const current = await stripe().subscriptions.retrieve(account.stripeSubscriptionId!);
      const item = current.items.data[0];
      if (item?.price.id === priceFor(plan) && !current.cancel_at_period_end) {
        throw new BadRequestException(`You're already on ${planFor(plan).name}`);
      }
      const updated = await stripe().subscriptions.update(current.id, {
        items: [{ id: item.id, price: priceFor(plan) }],
        proration_behavior: "create_prorations",
        // Switching plans also means staying: undo a pending cancellation.
        cancel_at_period_end: false,
        expand: ["default_payment_method"],
      });
      await this.sync(updated);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Couldn't change the plan: ${stripeError(err)}`);
    }
  }

  private async ensureCustomer(ctx: BusinessContext): Promise<AccountRow> {
    const existing = await prisma.billingAccount.findUnique({ where: { businessId: ctx.businessId } });
    if (existing) return existing;
    const [business, user] = await Promise.all([
      prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId }, select: { name: true } }),
      ctx.userId ? prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true } }) : null,
    ]);
    try {
      const customer = await stripe().customers.create(
        { name: business.name, email: user?.email, metadata: { businessId: ctx.businessId } },
        // Two quick clicks shouldn't create two Stripe customers.
        { idempotencyKey: `customer-${ctx.businessId}` },
      );
      return await prisma.billingAccount.upsert({
        where: { businessId: ctx.businessId },
        create: { businessId: ctx.businessId, stripeCustomerId: customer.id, billingEmail: user?.email },
        update: {},
      });
    } catch (err) {
      throw new BadRequestException(`Couldn't set up billing: ${stripeError(err)}`);
    }
  }

  private async invoices(customerId: string): Promise<BillingInvoice[]> {
    try {
      const list = await stripe().invoices.list({ customer: customerId, limit: INVOICE_LIMIT });
      return list.data
        .filter((invoice) => invoice.status !== "draft")
        .map((invoice) => ({
          id: invoice.id ?? "",
          number: invoice.number ?? undefined,
          createdAt: new Date(invoice.created * 1000).toISOString(),
          amountDue: invoice.amount_due,
          amountPaid: invoice.amount_paid,
          currency: invoice.currency,
          status: invoice.status ?? "open",
          hostedUrl: invoice.hosted_invoice_url ?? undefined,
          pdfUrl: invoice.invoice_pdf ?? undefined,
        }));
    } catch (err) {
      // The page still works without the list; Stripe's portal has them too.
      this.logger.warn(`Couldn't list invoices for ${customerId}: ${stripeError(err)}`);
      return [];
    }
  }

  private requireConfigured() {
    if (!billingConfigured()) {
      throw new BadRequestException("Payments aren't set up on this server yet. Change the plan directly instead.");
    }
  }
}
