## listen

```yaml
  - name: client/tcp
    type: tcp
    port: 1080
    pass: client/socks5
```

## connect

```yaml
  - name: client/tcp
    type: tcp
    pass: 127.0.0.1:1080
```

## free

```yaml
  - name: client/tcp
    type: tcp
```
