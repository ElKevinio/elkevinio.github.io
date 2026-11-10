# Vinyl · Audio-Equalizer

Manuelle Installation ohne Store in Desktop-Chrome 116+ bzw. aktuellem Edge:

1. Den Ordner dauerhaft entpacken.
2. chrome://extensions bzw. edge://extensions öffnen.
3. Entwicklermodus einschalten, „Entpackte Erweiterung laden“, diesen Ordner wählen.
4. Die Vinyl-Seite neu laden, Erweiterung anheften.
5. Im Vinyl-Tab Musik starten und einmal auf das Erweiterungssymbol klicken.

Die Webseite verbindet den Equalizer automatisch mit einer laufenden Analyse. Das
bloße Erkennen der Installation darf aus Browsergründen keine Aufnahme starten.
Erneuter Symbolklick stoppt sie. Bei Navigation/Neuladen endet die Analyse und muss
erneut über das Erweiterungssymbol gestartet werden. Es wird ausschließlich Tab-Audio (kein Mikrofon,
kein Bildschirmvideo) nach ausdrücklichem Erweiterungsklick analysiert. Kein Audio
wird gespeichert oder übertragen. Nur 32 Frequenzwerte werden lokal an den Tab
weitergereicht. Chrome kann einen Aufnahmeindikator anzeigen. Die normale
Bildschirmfreigabeleiste wird für diese Verbindung nicht benötigt.

Zugelassene Seiten: https://vinyl.elkevinio.de, http://localhost:8000 und
http://127.0.0.1:8000. Keine Verbindung zur Anmeldung oder zu Firebase. Die
Erweiterung liest keine Spotify-Tokens. Alle Skripte sind lokal im Paket enthalten.

Berechtigungen: activeTab (explizit angeklickter Tab), tabCapture (Audio des Tabs),
offscreen (AudioContext unabhängig von Popup-Fenstern). Kein Store und keine
automatischen Updates. Bei Updates Dateien ersetzen und Erweiterung neu laden.
Safari, mobile Browser und eingebetteter Codex-Browser werden nicht unterstützt.
Geschützte Medien können je nach Browser stumm geliefert werden.
