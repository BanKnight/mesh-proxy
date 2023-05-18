## transform

```yaml
components:
  - name: client/tcp
    type: tcp
    listen: 1080
    pass: client/socks5

  - name: client/socks5
    type: socks5
    passes:
      tcp: server/free
    users: []

  - name: server/free
    type: tcp
```
