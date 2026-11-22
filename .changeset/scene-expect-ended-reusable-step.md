---
'foldkit': patch
---

Make a `Scene.Mount.expectEnded(...)` step safe to reuse across scenes. The step removed each acknowledged Mount from the list of Mounts it was given, so after its first scene that list was empty. A step value shared between scenes, such as `const acknowledgeClosedPanel = Scene.Mount.expectEnded(Panel)`, then acknowledged nothing in every later scene: the scene failed with "I found Mounts that ended without being acknowledged", and a scene where the Mount had not unmounted passed the step instead of throwing. The step now leaves its Mounts unchanged, so it acknowledges the same Mounts and throws the same error in every scene it runs in.
