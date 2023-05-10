## pass

```yaml
  - name: server/vless-dispatch
    type: vless
    passes:
      tcp: server/tcp
      udp: server/udp
    users:
      - id: donghuicheng

  - name: server/tcp
    type: tcp
```
