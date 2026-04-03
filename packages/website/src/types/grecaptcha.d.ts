interface GrecaptchaEnterprise {
  ready(callback: () => void): void;
  execute(siteKey: string, options: { action: string }): Promise<string>;
}

interface Grecaptcha {
  enterprise: GrecaptchaEnterprise;
}

declare const grecaptcha: Grecaptcha;
