# Swish-kalkylator

**Svenska** · [English](README.en.md)

[![CodeRabbit Reviews](https://img.shields.io/coderabbit/prs/github/kjez66/swish_calculator?labelColor=171717&color=FF570A&label=CodeRabbit+Reviews)](https://coderabbit.ai)

Ett enkelt verktyg för att ta betalt med Swish i föreningens kiosk, på marknaden eller i
caféet, med din mobil.

> **Obs! Det här är inget certifierat kassaregister.** Swish-kalkylatorn är ett enkelt
> hjälpmedel för små föreningar och liknande, till exempel lagets kiosk eller klassens
> fikaförsäljning. Den har ingen kontrollenhet och uppfyller inte Skatteverkets krav på
> kassaregister. Måste din verksamhet ha ett kassaregister, vilket kan gälla även när
> kunderna betalar med Swish, så ersätter den inte ett sådant. Är du osäker, läs
> [Skatteverkets regler om kassaregister](https://www.skatteverket.se/foretag/drivaforetag/kassaregister.4.121b82f011a74172e5880005263.html).
> Verktyget kommer utan garantier, se [licensen](LICENSE).

Du trycker in det kunden köper på din egen mobil, och den gör en Swish-QR-kod med
exakt belopp. Kunden skannar koden, och Swish-appen öppnas med ditt nummer, beloppet
och ett meddelande redan ifyllda. Har du en andra mobil kan den stå vänd mot kunden och
visa QR-koden åt dig. Ingen kortläsare, inget abonnemang och ingen app att ladda ner.

<p align="center">
  <img src="docs/images/till.png" width="260" alt="Kassan på säljarens mobil: varuknappar i ett rutnät, två kaffe, en korv med bröd och ett hembakat i varukorgen, 75 kr totalt och en stor knapp Ta betalt">
  &nbsp;&nbsp;
  <img src="docs/images/display-pay.png" width="260" alt="Kundens skärm: butiksnamnet, 75,00 kr, en stor QR-kod och Swish-logotypen, med texten Öppna Swish-appen och skanna QR-koden">
</p>
<p align="center"><sub>Till vänster: din mobil, kassan. Till höger: kundens skärm. (Testdata.)</sub></p>

## Det här behöver du

- **En mobil, surfplatta eller dator till dig.** Det är kassan. Allt med en modern
  webbläsare fungerar.
- **En andra enhet till kunden, om du vill (behövs inte).** Den visar QR-koden vänd mot
  kunden, så att du slipper vända på din egen skärm. Den kan vara en gammal mobil som
  ligger i en låda, eller en surfplatta eller dator. Utan den visas QR-koden på din
  egen skärm i stället.
- **Internet på alla enheter du använder**, via wifi eller mobildata. Det här behövs:
  kassan fungerar inte utan uppkoppling.
- **Ett Swish-nummer** som kan ta emot betalningar.
- **Ett gratis konto på [GitHub](https://github.com/signup)** och **ett gratis konto på
  [Cloudflare](https://dash.cloudflare.com/sign-up).** Kassan körs hos Cloudflare, och
  GitHub sparar din kopia av den. Du behöver inte kunna något om dem: du klickar dig
  bara igenom stegen nedan en gång. Deras sidor är på engelska.

Det kostar ingenting att köra. Cloudflares gratisnivå räcker med god marginal för en
kiosk.

## Steg 1: Skaffa din egen kassa

Klicka på knappen:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kjez66/swish_calculator)

1. Logga in på Cloudflare (eller skapa kontot) när du blir ombedd.
2. Koppla ditt GitHub-konto när du blir ombedd. Cloudflare lägger din egen kopia av
   kassan där.
3. Låt de föreslagna namnen vara som de är och klicka på **Create and deploy**.
4. Vänta ett par minuter. När det är klart visar Cloudflare kassans adress. Den ser ut
   ungefär som `https://swish-kassa.ditt-namn.workers.dev`. **Skriv upp den.** Det är
   din kassa.

Kassan är bara din: den körs i ditt Cloudflare-konto, och din försäljning sparas där,
inte hos någon annan. Om andra öppnar din adress får de var sin egen kassa och kan inte
se din.

## Steg 2: Ställ in din mobil (kassan)

Stegen säger ”mobil”, men en surfplatta fungerar på samma sätt. På en dator öppnar du
adressen i webbläsaren och sparar den som bokmärke.

1. Öppna kassans adress på din mobil.
2. **Lägg den på hemskärmen**, så att den öppnas som en app:
   - **Android (Chrome):** menyn (⋮) → **Installera app** (eller **Lägg till på
     startskärmen**).
   - **iPhone (Safari):** dela-knappen (□↑) → **Lägg till på hemskärmen**. Öppna sedan
     kassan från den nya ikonen och gör resten av inställningarna där. På en iPhone
     delar appen på hemskärmen ingenting med Safari, så en kassa som du har ställt in i
     Safari finns inte i appen.
3. Tryck på kugghjulet (⚙) för att öppna inställningarna:
   - **Butiksnamn:** namnet på er kiosk, ert café eller er förening. Det visas för
     kunden och står i meddelandet på varje betalning.
   - **Swish-nummer:** numret som pengarna ska till.
   - **Produkter:** dina varor och priser. En ny kassa har en exempelmeny; ändra den, ta
     bort det du inte säljer och lägg till dina egna. **Aktiv** döljer en vara i kassan
     utan att ta bort den, för när något tar slut.
4. Tryck på **Spara**.

## Steg 3: Ställ in kundens mobil (displayen, valfritt)

Ingen andra enhet? Hoppa över det här steget. När du trycker på **Ta betalt** visas
QR-koden på din egen skärm, och du vänder den mot kunden.

1. Tryck på **Ingen display** högst upp i kassan på din mobil. En QR-kod och en
   sexsiffrig kod visas.
2. Skanna QR-koden med kameran på kundens mobil. Displayen öppnas och kopplar upp sig
   mot din kassa av sig själv. (Eller öppna kassans adress följd av `/display`, till
   exempel `https://swish-kassa.ditt-namn.workers.dev/display`, och skriv in koden.)
3. Din mobil visar nu **Display ansluten**. Det här gör du bara en gång.
4. Lägg gärna displayen på hemskärmen också, på samma sätt som kassan, så öppnas den i
   helskärm. På en iPhone gör du det innan du kopplar ihop, och skriver in koden i
   appen.
5. På kundens mobil: **skruva upp ljusstyrkan till max, stäng av automatisk ljusstyrka
   och ställ in skärmen så att den aldrig släcks.** En mörk skärm utomhus är den
   vanligaste anledningen till att en QR-kod inte går att skanna.

<p align="center">
  <img src="docs/images/display-welcome.png" width="220" alt="Kundens skärm medan den väntar: butiksnamnet, Välkommen och Betala med Swish">
</p>
<p align="center"><sub>Mellan kunderna visar displayen butiksnamnet och ”Betala med Swish”.</sub></p>

## Sälja

1. Tryck på varorna som kunden vill ha. Tryck igen för fler av samma. Summan står
   längst ner; tryck på antalet varor för att se listan och ändra i den.
2. Tryck på **Ta betalt**. QR-koden visas på din skärm, och på kundens skärm om du
   har en.
3. Kunden skannar den med Swish-appen och betalar.
4. **Kontrollera i din egen Swish-app att pengarna har kommit in.** Tryck sedan på
   **Klar**. Köpet sparas, och kundens skärm tackar, om du har en.

**Avbryt** stänger betalningen utan att spara något och behåller varorna, för ”vänta,
jag tar en bulle också”. Papperskorgen tömmer hela varukorgen.

## Efter dagen

Diagramknappen (📊) visar försäljningen för varje dag: antal köp, summan, hur mycket
som sålts av varje vara och varje köp med klockslag. **Ladda ner PDF** sparar en
rapport på en sida att lämna in. Jämför summan med din Swish-app.

Försäljningen sparas i 31 dagar och tas sedan bort automatiskt.

## Bra att veta

- **Kassan kan inte se om kunden har betalat.** Swish berättar inte det för den.
  ”Klar” betyder att *du* har sett pengarna komma in i din egen Swish-app. Kontrollera
  alltid innan du trycker.
- **Gör ett testköp före den första riktiga försäljningen.** Slå in ett litet köp, skanna
  koden med din egen Swish-app och kontrollera att numret, beloppet och meddelandet
  stämmer. Du kan avbryta i Swish-appen utan att betala.
- **Kassan bor i din mobils webbläsare.** Det finns ingen inloggning. Om du rensar
  webbläsarens data eller byter mobil glömmer mobilen kassan och börjar om med en ny,
  tom kassa, och den gamla försäljningen går inte att få tillbaka. En iPhone kan också
  glömma den om du inte öppnar den på en vecka. Att lägga kassan på hemskärmen gör det
  mycket mindre troligt. Om det händer: fyll i inställningarna igen och koppla ihop
  displayen igen (steg 3).
- **Vilket Swish-nummer?** Kassan tar både privat Swish (börjar med 07) och Swish för
  företag och föreningar (börjar med 123). Kontrollera att ditt Swish-avtal tillåter
  den sortens försäljning du har.
- **Nya versioner:** din kopia ändras inte när det här projektet ändras, så inget
  ändras mitt under en försäljning. Se [Uppdatera din kassa](#uppdatera-din-kassa).

## Uppdatera din kassa

Kassan uppdateras inte av sig själv: när det kommer en ny version hämtar du den. Hur du
får veta när det kommer säkerhetsrättningar står i [säkerhetspolicyn](SECURITY.md#på-svenska).
Uppdatera en dag då du inte säljer, och gör ett testköp efteråt.

**Första gången: koppla kassan till en fork.** Kopian som Cloudflare gjorde i steg 1 kan
inte hämta nya versioner. Det kan en *fork*: en kopia som GitHub håller ihop med det här
projektet. Kassan behåller sin adress, sina inställningar och sin försäljning. Det enda
som ändras är varifrån Cloudflare hämtar koden.

1. Öppna [projektet](https://github.com/kjez66/swish_calculator) på GitHub, klicka på
   **Fork** och sedan på **Create fork**.
2. Öppna **Workers & Pages** på Cloudflare, klicka på **swish-kassa** och gå till
   **Settings** och sedan **Build**.
3. Klicka på **Disconnect** för att släppa den gamla kopian. Klicka sedan på **Connect**
   och välj din fork och grenen **master**. Låt de andra inställningarna vara. Finns inte
   din fork i listan, ge Cloudflare tillgång till den när du blir ombedd.
4. Cloudflare bygger kassan först när din fork ändras. För att få den nyaste versionen
   direkt, gör en liten ändring i din fork på GitHub: klicka på **Add file** och sedan
   **Create new file**, döp filen till `min-kassa.md`, skriv vad som helst i den och
   klicka på **Commit changes**. Efter ett par minuter kör kassan den nya versionen.

Det här kräver att kassan heter `swish-kassa`, som föreslogs i steg 1. Heter den något
annat stoppar Cloudflare med ett fel i stället för att ändra något.

Den gamla kopian från steg 1 används inte längre. Du kan ta bort den på GitHub om du vill.

**Varje gång efter det:**

1. Öppna din fork på GitHub och klicka på **Sync fork** och sedan på **Update branch**.
2. Vänta ett par minuter. Cloudflare bygger och driftsätter den nya versionen av sig
   själv.
3. Gör ett testköp.

## För utvecklare

Kräver Node.js 24, nuvarande LTS (22 fungerar också).

```bash
npm install
npm run dev       # http://localhost:8787 i den riktiga Workers-miljön
npm test          # alla tester, i Workers-miljön
npm run check     # lint och formatering (Biome); npm run format rättar formateringen
npm run deploy    # driftsätt till ditt Cloudflare-konto (kör npx wrangler login först)
```

Allt är vanlig HTML, CSS och JavaScript utan byggsteg. En Cloudflare Worker skickar
`/api/*` vidare till Durable Objects: en per kassa (inställningar, varor, försäljning
och den direkta WebSocket-anslutningen till displayen) och en gemensam katalog för
kopplingskoder och begränsning av antal anrop. Kundens display (`public/display.js`)
hålls i ES5 så att den fungerar på gamla mobiler; ett test ser till det.

| Sökväg | Vad |
|---|---|
| `public/` | De två sidorna, som statiska filer: `index.html` och `app.js` (kassan), `display.html` och `display.js` (kundens display) |
| `public/shared/` | Kod för belopp, Swish-QR-innehåll, försäljningssammanställning och PDF-rapport, delad med servern |
| `public/_headers` | Säkerhetshuvuden för de statiska filerna |
| `src/` | Worker och Durable Objects |
| `src/defaults.js` | Exempelmenyn som en ny kassa börjar med |
| `tests/` | Tester, körs med `npm test` |
| `wrangler.jsonc` | Cloudflare-inställningar |

Formatet för QR-kodens innehåll är dokumenterat av användare, inte publicerat av
Getswish. Testerna visar att appen skapar den text den ska, men inte att Swish godtar
den; det är testköpet ovan som visar det.

## Licens

MIT, se [`LICENSE`](LICENSE). Namnet Swish och Swish-logotypen tillhör Getswish AB och
omfattas inte av licensen; Lucide-ikonerna har sin egen licens. Se
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
