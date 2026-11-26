# LinkedIn et X, en français

## LinkedIn

Je pilote mes agents de code à la voix, téléphone verrouillé dans la poche.

J'utilise T3 Code pour faire tourner Claude et Codex sur mon serveur. Le problème : dès que
je m'éloigne de l'écran, les agents attendent, et je ne sais pas quand une tâche est finie.

Alors j'ai construit T3 Voice, un compagnon vocal open source (non officiel) :
→ « Lance Claude sur tel projet pour corriger les tests »
→ « Qu'est-ce qui tourne ? »
→ « Dis-lui d'ajouter un test »
→ et il m'annonce à voix haute quand une tâche est terminée, avec un résumé.

Sous le capot : une app iOS en SwiftUI qui ne transporte que l'audio (WebRTC), et un
service Node à côté du serveur, en architecture hexagonale, fermé par défaut (Face ID,
jeton par appareil, aucune donnée sensible dans les logs).

C'est en français pour l'instant, sous licence MIT, et je cherche des contributeurs,
notamment pour l'anglais. Le lien est en commentaire.

[vidéo]

## X (un seul post)

J'ai construit un compagnon vocal open source pour T3 Code : je lance et suis mes agents
Claude/Codex à la voix, iPhone verrouillé dans la poche 🎧

En français pour l'instant, MIT, contributeurs bienvenus 👇
https://github.com/thomaseude/t3code-voice

[vidéo]
