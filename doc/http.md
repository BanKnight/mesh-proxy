## Server

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
        pass:
```
