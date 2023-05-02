FROM node:slim as builder

WORKDIR /app

COPY package*.json ./

RUN npm install 

COPY / .

RUN npm run build

FROM node:slim

ARG TZ='Asia/Shanghai'
ENV TZ ${TZ}
RUN ln -sf /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo ${TZ} > /etc/timezone

WORKDIR /app

COPY --from=builder /app ./

CMD ["node","."]
