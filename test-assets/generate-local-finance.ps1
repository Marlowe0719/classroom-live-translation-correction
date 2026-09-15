$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$referencePath = Join-Path $PSScriptRoot 'finance-reference.txt'
$audioPath = Join-Path $PSScriptRoot 'finance-english.wav'
$referenceText = [System.IO.File]::ReadAllText($referencePath).Trim()
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
    if (-not $voice) { throw 'No enabled US English TTS voice is installed.' }
    $synth.SelectVoice($voice.VoiceInfo.Name)
    $synth.Rate = 0
    $synth.Volume = 100
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($audioPath, $format)
    $synth.Speak($referenceText)
    $synth.SetOutputToNull()
    Write-Output ('Generated locally with ' + $voice.VoiceInfo.Name)
} finally {
    $synth.Dispose()
}
