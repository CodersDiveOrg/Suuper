// Standalone embed widget: loaded via <script> on an arbitrary third-party
// site, so it must not assume React, a bundler, or any global is present.
// Everything renders inside a Shadow DOM root to avoid colliding with the
// host page's CSS.

interface Product {
  id: string;
  title: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl: string;
}

interface ChatMessageResponse {
  reply: string;
  products: Product[];
}

interface ChatEntry {
  role: "user" | "assistant" | "error";
  content: string;
  products?: Product[];
}

function readConfig() {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) throw new Error("Chat widget: could not find its own <script> tag");

  const widgetKey = script.dataset.widgetKey;
  if (!widgetKey) throw new Error("Chat widget: data-widget-key is required");

  return {
    widgetKey,
    gatewayOrigin: new URL(script.src).origin,
    themeColor: script.dataset.themeColor ?? "#111827",
    greeting: script.dataset.greeting ?? "Hi! How can I help you today?",
    position: script.dataset.position === "bottom-left" ? "bottom-left" : "bottom-right",
  };
}

function formatPrice(product: Product): string {
  if (product.price === undefined) return "";
  return ` — ${product.price} ${product.currency ?? ""}`.trimEnd();
}

function renderWidget(config: ReturnType<typeof readConfig>) {
  const host = document.createElement("div");
  host.id = "ai-platform-widget-root";
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  const side = config.position === "bottom-left" ? "left" : "right";
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
      .launcher {
        position: fixed; bottom: 20px; ${side}: 20px; z-index: 2147483000;
        width: 56px; height: 56px; border-radius: 999px; border: none; cursor: pointer;
        background: ${config.themeColor}; color: #fff; font-size: 24px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      }
      .panel {
        position: fixed; bottom: 88px; ${side}: 20px; z-index: 2147483000;
        width: 340px; max-height: 480px; display: none; flex-direction: column;
        background: #fff; border-radius: 12px; overflow: hidden;
        box-shadow: 0 8px 30px rgba(0,0,0,0.2); border: 1px solid #e5e7eb;
      }
      .panel.open { display: flex; }
      .header { background: ${config.themeColor}; color: #fff; padding: 12px 14px; font-size: 14px; font-weight: 600; }
      .messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 200px; }
      .bubble { padding: 8px 10px; border-radius: 10px; font-size: 13px; line-height: 1.4; max-width: 85%; white-space: pre-wrap; }
      .bubble.assistant { background: #f3f4f6; color: #111827; align-self: flex-start; }
      .bubble.user { background: ${config.themeColor}; color: #fff; align-self: flex-end; }
      .bubble.error { background: #fef2f2; color: #b91c1c; align-self: flex-start; }
      .product { display: block; margin-top: 6px; padding: 6px; border: 1px solid #e5e7eb; border-radius: 8px; text-decoration: none; color: inherit; font-size: 12px; }
      .product img { width: 100%; height: 80px; object-fit: cover; border-radius: 6px; margin-bottom: 4px; }
      .product .title { font-weight: 600; }
      form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #e5e7eb; }
      input { flex: 1; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font-size: 13px; }
      button.send { background: ${config.themeColor}; color: #fff; border: none; border-radius: 8px; padding: 0 12px; cursor: pointer; }
      button.send:disabled { opacity: 0.6; cursor: default; }
    </style>
    <button class="launcher" aria-label="Open chat">💬</button>
    <div class="panel">
      <div class="header">Chat with us</div>
      <div class="messages"></div>
      <form>
        <input type="text" placeholder="Type a message…" autocomplete="off" />
        <button type="submit" class="send">Send</button>
      </form>
    </div>
  `;

  const launcher = root.querySelector<HTMLButtonElement>(".launcher")!;
  const panel = root.querySelector<HTMLDivElement>(".panel")!;
  const messagesEl = root.querySelector<HTMLDivElement>(".messages")!;
  const form = root.querySelector<HTMLFormElement>("form")!;
  const input = root.querySelector<HTMLInputElement>("input")!;
  const sendButton = root.querySelector<HTMLButtonElement>("button.send")!;

  const history: ChatEntry[] = [{ role: "assistant", content: config.greeting }];
  let opened = false;

  function renderMessages() {
    messagesEl.innerHTML = "";
    for (const entry of history) {
      const bubble = document.createElement("div");
      bubble.className = `bubble ${entry.role}`;
      bubble.textContent = entry.content;
      messagesEl.appendChild(bubble);

      for (const product of entry.products ?? []) {
        const link = document.createElement("a");
        link.className = "product";
        link.href = product.productUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.innerHTML = `
          ${product.imageUrl ? `<img src="${product.imageUrl}" alt="" />` : ""}
          <div class="title">${product.title}${formatPrice(product)}</div>
        `;
        messagesEl.appendChild(link);
      }
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function sendMessage(message: string) {
    history.push({ role: "user", content: message });
    renderMessages();
    input.value = "";
    sendButton.disabled = true;

    try {
      const response = await fetch(
        `${config.gatewayOrigin}/public/widget/${config.widgetKey}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const data = (await response.json()) as ChatMessageResponse;
      history.push({ role: "assistant", content: data.reply, products: data.products });
    } catch {
      history.push({ role: "error", content: "Sorry, something went wrong. Please try again." });
    } finally {
      sendButton.disabled = false;
      renderMessages();
    }
  }

  launcher.addEventListener("click", () => {
    opened = !opened;
    panel.classList.toggle("open", opened);
    if (opened) renderMessages();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (message) void sendMessage(message);
  });

  renderMessages();
}

try {
  renderWidget(readConfig());
} catch (error) {
  console.error("[ai-platform-widget]", error);
}
