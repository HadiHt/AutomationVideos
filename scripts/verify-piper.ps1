$voice = "C:\Users\hadih\Repos\AutomationVideos\voices\en_US-lessac-medium.onnx"
$output = "C:\Users\hadih\Repos\AutomationVideos\temp\piper-check.wav"
New-Item -ItemType Directory -Force "C:\Users\hadih\Repos\AutomationVideos\temp" | Out-Null
"Automation Videos Piper check." | & "C:\Users\hadih\AppData\Local\Programs\Python\Python313\Scripts\piper.exe" --model $voice --output_file $output
Write-Output $output
