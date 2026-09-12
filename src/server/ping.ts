type Fetch = typeof fetch;

interface PingWebhookPayload {
  userEmail: string;
  title: string;
  text: string;
  source: string;
}

export class PingClient {
  constructor(
    private readonly webhookUrl: string,
    private readonly webhookToken: string,
    private readonly userEmail: string,
    private readonly request: Fetch = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.webhookToken && this.userEmail);
  }

  async sendOtp(code: string, deviceName: string): Promise<void> {
    await this.notify({
      userEmail: this.userEmail,
      title: "Comote login code",
      text: `Your Comote login code is: ${code}\n\nIt expires in 5 minutes and can be used once.\nDevice: ${safeDeviceName(deviceName)}\n\nIf you did not request this code, you can ignore this message.`,
      source: "Comote",
    });
  }

  async notifyPasswordLogin(deviceName: string): Promise<void> {
    await this.notify({
      userEmail: this.userEmail,
      title: "Comote password login",
      text: `A Comote session was opened using the password fallback.\nDevice: ${safeDeviceName(deviceName)}\nTime: ${new Date().toISOString()}`,
      source: "Comote",
    });
  }

  async sendNotice(title: string, text: string): Promise<void> {
    await this.notify({
      userEmail: this.userEmail,
      title: title.trim().slice(0, 120),
      text: text.trim().slice(0, 2_000),
      source: "Comote",
    });
  }

  private async notify(payload: PingWebhookPayload): Promise<void> {
    if (!this.enabled) throw new Error("Ping is not configured.");
    let response: Response;
    try {
      response = await this.request(this.webhookUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.webhookToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new Error("Ping delivery is temporarily unavailable.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Ping delivery failed (${response.status}).`);
    }
    await response.body?.cancel().catch(() => undefined);
  }
}

function safeDeviceName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 40) || "Unknown device";
}
