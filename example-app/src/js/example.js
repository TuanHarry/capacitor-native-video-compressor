import { NativeVideoCompressor } from 'capacitor-native-video-compressor';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    NativeVideoCompressor.echo({ value: inputValue })
}
