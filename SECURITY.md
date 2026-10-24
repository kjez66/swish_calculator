# Security policy

[På svenska](#på-svenska) · **English**

Swish Calculator puts a Swish QR code in front of paying customers, so the worst bug it
can have is one that sends their money somewhere else. Reports like that are very
welcome, and are handled before anything else.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub instead:
go to the [Security tab](https://github.com/kjez66/swish_calculator/security) and click
**Report a vulnerability**. Only the maintainers can see the report.

Helpful things to include:

- what an attacker can do, and what they need first (a pairing code, the display phone,
  nothing at all)
- steps to reproduce it, ideally against `npm run dev`
- the commit you tested

This is a small volunteer project, so these are aims rather than guarantees:

| | |
|---|---|
| First reply | within 7 days |
| Fix for a serious issue | within 30 days |
| Public advisory | when the fix is on `master`, agreed with you |

You will be credited in the advisory unless you would rather not be.

## Supported versions

Only the latest commit on `master` gets security fixes. There are no release branches.

Every till is its own copy, deployed to its owner's Cloudflare account, and a copy does
not change when this project does. Fixes are therefore announced as
[GitHub security advisories](https://github.com/kjez66/swish_calculator/security/advisories);
watch the repository (**Watch → Custom → Security alerts**) to hear about them, and
update your copy to get them ([how](README.en.md#updating-your-till)).

## Scope

Most interesting:

- making a till or display show a QR code, amount or Swish number its owner did not set
- using a till's settings, products, charges or sales without its operator token
- connecting a display to a till without a pairing code that till's operator created,
  or guessing or reusing pairing codes
- a display token doing anything beyond showing the till's display
- script injection (XSS) in the till or display pages
- a QR payload that charges a different amount or recipient than the screen shows

Not in scope:

- Swish, the banks and Cloudflare themselves: report those to them
- someone holding the unlocked till phone. There is no login by design: the till lives in
  the phone's browser
- flooding a till with traffic or using up its owner's Cloudflare free plan
- the till not being a certified cash register. It is not one, and says so
- copies their owners have changed
- scanner output or missing headers without a way to actually exploit them

## Testing

- Test against `npm run dev` or a till you deployed yourself. Never test against
  someone else's till, including the maintainers' own.
- Do not make real Swish payments to anyone but yourself.
- Stop and report as soon as you can show the problem. Do not access, change or keep
  other people's data.

Research done in good faith under these rules is welcome, and will not be met with legal
action.

## På svenska

Har du hittat en säkerhetsbrist? **Skapa inget öppet ärende.** Rapportera den privat i
[fliken Security](https://github.com/kjez66/swish_calculator/security) via **Report a
vulnerability**. Det viktigaste vi vill veta om är allt som kan få pengar att hamna hos
fel mottagare.

Bara den senaste versionen på `master` får säkerhetsrättningar. Din kassa är en egen kopia
som inte uppdateras av sig själv, så rättningar meddelas som
[säkerhetsmeddelanden på GitHub](https://github.com/kjez66/swish_calculator/security/advisories).
Bevaka projektet (**Watch → Custom → Security alerts**) för att få veta när du behöver
uppdatera din kopia ([så här](README.md#uppdatera-din-kassa)).

Testa bara mot `npm run dev` eller din egen kassa, aldrig mot någon annans.
