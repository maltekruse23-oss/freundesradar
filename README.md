# FreundesRadar

Die Abenteurer-Chronik eurer Gruppe in **WoW Forever**: Stufen, Ausrüstung, Berufe, Erfolge und ein Levelrennen bis Stufe 60. Ohne Download: Charakter mit Vor- und Nachnamen eintragen, fertig.

**Seite:** https://maltekruse23-oss.github.io/freundesradar/

## Mitmachen

1. Den Einladungslink öffnen. Er enthält den Gruppencode hinter dem `#`.
2. „Charakter hinzufügen“, Vor- und Nachnamen eintippen, Region wählen.
3. Oder unter „Ganze Gilde“ den Gildennamen eintragen. Dann erscheinen alle Mitglieder, auch spätere.

Blizzard zeigt Charaktere erst ab Stufe 10. Kleinere erscheinen automatisch, sobald sie Stufe 10 erreichen.

## So funktioniert es

- `index.html` ist die ganze Seite. Sie liest die Daten aus Supabase und bekommt Änderungen live (Realtime).
- `supabase/functions/radar` ist eine Edge Function. Sie fragt die Blizzard-API (Namespace `profile-forever-eu` bzw. `-us`) nach Profil, Ausrüstung, Bild, Berufen, Werten und Erfolgen und schreibt neue Stufen, Beute und Erfolge in die Chronik.
- Ein `pg_cron`-Job ruft die Funktion alle 5 Minuten auf. Blizzard aktualisiert ein Profil, sobald sich der Charakter ausloggt.

Einen echten Online-Status liefert die Blizzard-API nicht. Die Seite zeigt deshalb „zuletzt gespielt“.

## Einrichtung

1. Unter https://develop.battle.net/access/clients einen API-Client anlegen.
2. In Supabase unter *Edge Functions → Secrets* `BNET_CLIENT_ID` und `BNET_CLIENT_SECRET` eintragen.
