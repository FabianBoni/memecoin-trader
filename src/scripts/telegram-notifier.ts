import "dotenv/config";

interface TelegramOptions {
  dedupeKey?: string;
  cooldownMs?: number;
  priority?: boolean;
}

const recentMessages = new Map<string, number>();
const sendTimestamps: number[] = [];
let suppressedCount = 0;

const DEFAULT_COOLDOWN_MS = Number(process.env.TELEGRAM_DEDUPE_MS || 60_000);
const BURST_WINDOW_MS = Number(process.env.TELEGRAM_BURST_WINDOW_MS || 300_000);
const MAX_MESSAGES_PER_WINDOW = Number(process.env.TELEGRAM_MAX_PER_WINDOW || 8);

function pruneOldState(now: number) {
  while (sendTimestamps.length > 0 && now - sendTimestamps[0]! > BURST_WINDOW_MS) {
    sendTimestamps.shift();
  }

  for (const [key, timestamp] of recentMessages.entries()) {
    if (now - timestamp > Math.max(DEFAULT_COOLDOWN_MS, BURST_WINDOW_MS)) {
      recentMessages.delete(key);
    }
  }
}

export async function sendTelegram(message: string, options: TelegramOptions = {}): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  if (!botToken || !chatId) {
    console.warn("Telegram notifier skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.");
    return;
  }

  const now = Date.now();
  pruneOldState(now);

  const dedupeKey = options.dedupeKey ?? message;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastSentAt = recentMessages.get(dedupeKey);
  if (lastSentAt !== undefined && now - lastSentAt < cooldownMs) {
    console.log(`Telegram notifier suppressed duplicate message for key: ${dedupeKey}`);
    suppressedCount += 1;
    return;
  }

  if (!options.priority && sendTimestamps.length >= MAX_MESSAGES_PER_WINDOW) {
    console.log(`Telegram notifier suppressed burst message for key: ${dedupeKey}`);
    suppressedCount += 1;
    recentMessages.set(dedupeKey, now);
    return;
  }

  recentMessages.set(dedupeKey, now);
  sendTimestamps.push(now);

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  console.log("Fetching:", url.replace(botToken, "<redacted>"));

  const text = suppressedCount > 0 && options.priority
    ? `ℹ️ <b>Telegram gedrosselt</b>\n${suppressedCount} Meldungen wurden zuletzt unterdrueckt.\n\n${message}`
    : message;

  if (options.priority) {
    suppressedCount = 0;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed with status ${response.status}: ${body}`);
  }
}
