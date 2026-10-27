Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
' base = scripts/, project root is parent
root = fso.GetParentFolderName(base)
cmd = "node """ & root & "\src\cli.mjs"" schedule-run"
shell.Run cmd, 0, True
