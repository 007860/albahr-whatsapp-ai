FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    flac \
    openssl \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir edge-tts SpeechRecognition Pillow || pip3 install --no-cache-dir edge-tts SpeechRecognition Pillow

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

RUN chmod -R 777 /app

ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "if [ -f cloud-data.enc ] && [ -n \"$DATA_ENCRYPTION_KEY\" ]; then openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in cloud-data.enc -out cloud-data.tar.gz -pass \"pass:$DATA_ENCRYPTION_KEY\" && tar -xzf cloud-data.tar.gz && rm -f cloud-data.tar.gz; fi; node whatsapp-bridge.js"]
