# tor-relay -- deployable on Render / PandaStack (NOT HF: content policy
# forbids Tor; NOT Railway: AUP bans proxies; NOT Vercel/CF: no daemons).
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        tor ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py start.sh torrc ./
RUN chmod +x start.sh

ENV PORT=7860
EXPOSE 7860
CMD ["./start.sh"]
