#!/usr/bin/env python3
import sys
import os
import subprocess
import tempfile
import speech_recognition as sr
import shutil

def get_ffmpeg_binary():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg") or "ffmpeg"

def transcribe(audio_path):
    ffmpeg_exe = get_ffmpeg_binary()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav:
        wav_path = tmp_wav.name

    try:
        subprocess.run(
            [ffmpeg_exe, "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", wav_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True
        )
        r = sr.Recognizer()
        with sr.AudioFile(wav_path) as source:
            audio_data = r.record(source)

        # Try English/Roman-Urdu (en-PK) and Urdu (ur-PK) and pick the best result
        text_en = ""
        text_ur = ""
        try:
            text_ur = r.recognize_google(audio_data, language="ur-PK")
        except Exception:
            pass
        try:
            text_en = r.recognize_google(audio_data, language="en-PK")
        except Exception:
            pass

        if text_ur and text_en:
            # Provide both if different so the AI has 100% clarity regardless of language spoken
            if text_ur.strip() == text_en.strip():
                print(text_ur.strip())
            else:
                print(f"{text_ur.strip()} ( / {text_en.strip()})")
        elif text_ur:
            print(text_ur.strip())
        elif text_en:
            print(text_en.strip())
        else:
            print("")
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        transcribe(sys.argv[1])
