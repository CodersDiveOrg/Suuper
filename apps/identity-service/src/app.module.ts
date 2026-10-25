import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./auth/auth.module";
import { BusinessesModule } from "./businesses/businesses.module";
import { MembersModule } from "./members/members.module";
import { InvitationsModule } from "./invitations/invitations.module";
import { RolesModule } from "./roles/roles.module";
import { MailModule } from "./mail/mail.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { AuditLogModule } from "./audit-log/audit-log.module";

@Module({
  imports: [
    MailModule,
    RolesModule,
    AuthModule,
    BusinessesModule,
    MembersModule,
    InvitationsModule,
    IntegrationsModule,
    OnboardingModule,
    AuditLogModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
