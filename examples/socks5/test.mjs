import dgram from "dgram"

const socket = dgram.createSocket("udp4")

socket.connect(8899, "192.168.31.250", () =>
{
    console.log("connect success!")


    for (let i = 0; i < 3; ++i)
    {
        socket.send("test hello " + i)
    }

})

socket.on("message", (data) =>
{
    console.log(data.toString("utf-8"))
})

socket.on("error", console.error)

