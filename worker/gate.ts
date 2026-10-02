const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The password page: one blank slip on the scanner bed. Works without JS. */
export function gate(next: string, wrong: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#060707">
<meta name="robots" content="noindex">
<title>!!!</title>
<link rel="preload" href="/fonts/ABCArealSuperfamilyVariable.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face {
  font-family: 'Areal';
  src: url('/fonts/ABCArealSuperfamilyVariable.woff2') format('woff2');
  font-weight: 400 700;
  font-display: swap;
}
html {
  color-scheme: dark;
  background: #060707;
  -webkit-tap-highlight-color: transparent;
}
body {
  margin: 0;
  min-height: 100svh;
  display: grid;
  place-items: center;
  background: radial-gradient(110% 80% at 30% 35%, #151918 0%, #0c0e0e 55%, #050606 100%);
}
form { margin-bottom: 12vh; }
input {
  display: block;
  width: 220px;
  height: 52px;
  padding: 0 18px;
  border: 0;
  border-radius: 0;
  outline: none;
  background: #fff;
  color: #000;
  caret-color: #000;
  font: 400 20px 'Areal', system-ui, sans-serif;
  letter-spacing: .08em;
  box-shadow: 0 0 0 .5px rgba(255, 255, 255, .25), 0 0 22px rgba(220, 235, 230, .07);
}
.no input { animation: no .32s cubic-bezier(.36, .07, .19, .97); }
@keyframes no {
  20%, 60% { transform: translateX(-7px); }
  40%, 80% { transform: translateX(7px); }
}
@media (prefers-reduced-motion: reduce) { .no input { animation: none; } }
</style>
</head>
<body>
<form method="post" action="/board/login"${wrong ? ' class="no"' : ''}>
<input type="password" name="p" aria-label="password" autocomplete="current-password" enterkeyhint="go" autofocus required>
<input type="hidden" name="next" value="${escapeAttr(next)}">
</form>
</body>
</html>`;
}
