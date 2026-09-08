import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const OTP_TTL_MS = 5 * 60_000;
const RESEND_DELAY_MS = 60_000;
const RATE_WINDOW_MS = 15 * 60_000;
const MAX_REQUESTS_PER_IP = 5;
const MAX_REQUESTS_GLOBAL = 10;
const MAX_VERIFY_ATTEMPTS = 5;

interface OtpChallenge {
  id: string;
  digest: Buffer;
  ip: string;
  deviceName: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

export interface CreatedOtpChallenge {
  challengeId: string;
  code: string;
  expiresAt: string;
  resendAfterSeconds: number;
}

export class OtpStore {
  private challenges = new Map<string, OtpChallenge>();
  private requestsByIp = new Map<string, number[]>();
  private globalRequests: number[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly generateCode: () => string = () => randomInt(0, 1_000_000).toString().padStart(6, "0"),
  ) {}

  create(ip: string, deviceName: string): CreatedOtpChallenge {
    const now = this.now();
    this.cleanup(now);
    const recent = this.requestsByIp.get(ip) ?? [];
    const lastRequest = recent.at(-1) ?? 0;
    if (now - lastRequest < RESEND_DELAY_MS) throw new Error("Wait before requesting another OTP.");
    if (recent.length >= MAX_REQUESTS_PER_IP || this.globalRequests.length >= MAX_REQUESTS_GLOBAL) {
      throw new Error("OTP requests are temporarily limited. Try again later.");
    }

    for (const [id, challenge] of this.challenges) {
      if (challenge.ip === ip) this.challenges.delete(id);
    }

    const id = randomBytes(32).toString("base64url");
    const code = this.generateCode();
    if (!/^\d{6}$/.test(code)) throw new Error("OTP generator returned an invalid code.");
    this.challenges.set(id, {
      id,
      digest: digestOtp(id, code),
      ip,
      deviceName,
      createdAt: now,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
    });
    recent.push(now);
    this.requestsByIp.set(ip, recent);
    this.globalRequests.push(now);
    return {
      challengeId: id,
      code,
      expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
      resendAfterSeconds: RESEND_DELAY_MS / 1_000,
    };
  }

  verify(challengeId: string, code: string, ip: string): { deviceName: string } {
    const now = this.now();
    this.cleanup(now);
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.ip !== ip) throw new Error("OTP is invalid or expired.");

    challenge.attempts += 1;
    const supplied = digestOtp(challenge.id, /^\d{6}$/.test(code) ? code : "invalid");
    const valid = timingSafeEqual(challenge.digest, supplied);
    if (!valid) {
      if (challenge.attempts >= MAX_VERIFY_ATTEMPTS) this.challenges.delete(challengeId);
      throw new Error("OTP is invalid or expired.");
    }

    this.challenges.delete(challengeId);
    return { deviceName: challenge.deviceName };
  }

  discard(challengeId: string): void {
    this.challenges.delete(challengeId);
  }

  private cleanup(now: number): void {
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    for (const [ip, requests] of this.requestsByIp) {
      const recent = requests.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
      if (recent.length) this.requestsByIp.set(ip, recent);
      else this.requestsByIp.delete(ip);
    }
    this.globalRequests = this.globalRequests.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  }
}

function digestOtp(challengeId: string, code: string): Buffer {
  return createHash("sha256").update(challengeId).update(":").update(code).digest();
}
