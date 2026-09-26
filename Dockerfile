# Cookie 发送决策实验室
FROM node:20-alpine

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷贝应用代码
COPY server.js ./
COPY lib ./lib
COPY data ./data
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
