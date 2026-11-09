# FOLLOW_UP

On branch `feat/azure-free-ar-eg-tts`, replaced Grok TTS with Azure Speech REST TTS using the explicit Egyptian Arabic locale `ar-EG` and voice `ar-EG-ShakirNeural`; Whisper remains forced to `ar`.
The Worker now expects `AZURE_SPEECH_KEY` as a secret and `AZURE_SPEECH_REGION` as an environment variable; Azure's F0 tier documents 500,000 free neural-TTS characters per month.
Re-read the changed source and Wrangler configuration and verified the Grok call is gone, but no build, runtime test, PR, merge, or deployment was performed; `main` and Production remain unchanged.
