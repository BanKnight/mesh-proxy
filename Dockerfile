FROM node:slim as builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm install 

COPY /src ./src

RUN npm run build

FROM node:slim

ARG TZ='Asia/Shanghai'
ENV TZ ${TZ}
RUN ln -sf /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo ${TZ} > /etc/timezone

WORKDIR /app

COPY --from=builder /app/dist ./

CMD node . -c $1
