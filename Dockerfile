FROM node:22-alpine

RUN apk add --no-cache libreoffice font-noto ttf-freefont plantuml

RUN npm install -g opencode-ai@latest

WORKDIR /workspace

EXPOSE 4096

ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
