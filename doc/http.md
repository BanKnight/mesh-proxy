## listen

```yaml
  - name: server/http
    type: https
    port: 443
    sites: 
      www.test.com:
        cert: "cert"
        key: "key"
        locations:
          /mesh:
            pass: client/channel
  
      "*.mr-tutu.com":
        pass: asdfasdf
```

## connect

```yaml
  - name: server/http
    type: http
    port: 443
    sites: 
      www.test.com:
        cert: "cert"
        key: "key"
        locations:
          /mesh:
            pass: client/channel
  
      "*.mr-tutu.com":
        pass:
```

## test

name: server/http

type: http

port: 443

ssl: true

host:
