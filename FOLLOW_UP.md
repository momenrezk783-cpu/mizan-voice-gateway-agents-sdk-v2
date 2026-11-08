# FOLLOW_UP

Fixed the public voice page call startup so microphone permission and AudioContext/AudioWorklet initialization complete before the WebSocket connects, with cancellation guards and cleanup for interrupted setup. Changes are on `fix/voice-audio-init-race`; no PR has been opened, and browser/device integration testing remains the next step.