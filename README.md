# Offside VAR

Een webapp die op basis van een **foto** of een **frame uit een video** inschat of een voetbalsituatie buitenspel is, en daarbij een **kans op buitenspel in procenten** geeft.

Het is bewust geen wetenschappelijk exacte VAR: de camera staat zelden precies op lijn. De app corrigeert daar zo goed mogelijk voor en vertaalt de resterende onzekerheid naar een percentage.

## Gebruik

1. Open de app (zie *Starten*) en kies een foto of video.
   - Bij een video: spoel naar het moment van de pass (met ◀/▶ per frame) en klik op **Gebruik dit frame**.
2. Markeer in het beeld:
   - **Aanvaller**: het voorste lichaamsdeel waarmee gescoord mag worden (niet de armen).
   - **Verdediger(s)**: het achterste lichaamsdeel van de voorlaatste verdediger. Markeer je er meer (bijv. ook de keeper), dan kiest de app zelf de voorlaatste.
   - **Bal** (optioneel): als de bal dichter bij het doel ligt dan de voorlaatste verdediger, bepaalt de bal de lijn.
   - **Referentielijnen** (sterk aanbevolen): twee lijnen die in het echt parallel lopen aan de doellijn, zoals de 16-meterlijn, de 5-meterlijn, de middellijn of de maaibanen in het gras.
3. Kies de aanvalsrichting en hoe schuin de camera staat.
4. Lees de uitslag af: percentage, oordeel (*Buitenspel* / *Twijfelgeval* / *Geen buitenspel*) en de geschatte afstand in centimeters.

Markeringen zijn te verslepen en met **Wissen** te verwijderen.

**Detecteer spelers (AI)** laadt een objectdetectiemodel (TensorFlow.js COCO-SSD) dat in je browser draait. Klik je daarna binnen een gevonden speler, dan gebruikt de app zijn lengte (~1,80 m) als schaal om pixels naar meters om te rekenen. Er wordt niets geüpload: alles blijft op je eigen apparaat.

## Hoe de inschatting werkt

- **Perspectief**: lijnen die parallel aan de doellijn lopen, komen in beeld samen in één verdwijnpunt. De buitenspellijn door de verdediger loopt ook naar dat punt. Zonder referentielijnen neemt de app aan dat de lijn verticaal in beeld loopt.
- **Afstand**: de loodrechte afstand van de aanvaller tot die lijn, omgerekend naar meters via de spelerlengte (of een grove schatting zonder detectie).
- **Kans**: `P(buitenspel) = Φ(afstand / σ)`, waarbij σ de onzekerheid in meters is: markeerfout, camerastand, ontbrekende referentielijnen, onbekende schaal en (bij video) het exacte moment van de pass. Gelijk staan geeft dus ~50%, en de app zegt nooit 0% of 100% (behalve als de aanvaller op eigen helft staat).

| Kans | Oordeel |
|---|---|
| ≥ 65% | Buitenspel |
| 35–65% | Twijfelgeval |
| ≤ 35% | Geen buitenspel |

## Starten

Het is een statische site zonder build-stap; ES-modules vereisen wel een webserver:

```bash
npm start            # of: python3 -m http.server 8080
```

Open daarna http://localhost:8080. Voor gebruik op je telefoon kun je de repo publiceren via GitHub Pages (Settings → Pages → branch kiezen).

## Tests

```bash
npm test
```

De rekenlogica staat los van de interface in `js/offside.js` en wordt getest in `test/offside.test.mjs`.

## Structuur

```
index.html          interface
css/styles.css      opmaak
js/app.js           upload, video-frames, markeren, tekenen, AI-detectie
js/offside.js       perspectief, afstand en kansberekening
test/               unit-tests (node --test)
```
