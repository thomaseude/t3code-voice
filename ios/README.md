# T3 Voice iOS app

The iPhone app of t3code-voice: it pairs with a `t3-voice` companion and starts voice
conversations behind Face ID. See the spec in issue #15.

Swift / SwiftUI, iOS 18 or later. Build it on a Mac with Xcode and
[XcodeGen](https://github.com/yonaskolb/XcodeGen): see "iOS app" in `AGENTS.md`.

## Start a conversation

Each way to start runs the same flow: Face ID, then the start sound, then you talk. When the
iPhone is locked, iOS asks for Face ID to unlock it. The app does not ask a second time if
that unlock used Face ID less than 10 seconds before; after an unlock with the passcode, it
asks again.
When a conversation already runs, starting again does nothing.

- **In the app**: the "Parler" button.
- **Siri**: say "Dis Siri, T3 Voix". "Dis Siri, parler à T3 Voix" works too. With Siri in
  English, say "Hey Siri, talk to T3 Voice".
- **Control Center**: open Control Center, tap "+" (top left), then "Ajouter une commande",
  and pick "Parler à T3" under T3 Voice.
- **Action Button**: in Settings > Action Button, swipe to "Raccourci", tap "Choisir un
  raccourci", and pick "Parler à T3" under T3 Voice. You can also swipe to "Commandes" and
  pick the same control as in Control Center.

Open the app once after installing it: iOS lists its Siri phrase and its shortcut only after
the first launch.
