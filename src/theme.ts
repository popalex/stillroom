import { themeSchema, type Theme } from '../shared/protocol';

// The server keeps each device's appearance, but it can only send it after
// sign-in. A cookie mirrors the choice so the sign-in screens and the first
// paint of every load use it too. It holds one word, never anything about the
// collection.
const COOKIE = 'stillroom-theme';

export function savedTheme(): Theme {
  const value = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const parsed = themeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'system';
}

export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function rememberTheme(theme: Theme) {
  applyTheme(theme);
  document.cookie =
    theme === 'system'
      ? `${COOKIE}=; Path=/; Max-Age=0; SameSite=Strict; Secure`
      : `${COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Strict; Secure`;
}
