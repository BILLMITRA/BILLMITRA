@echo off
setlocal
set "EDITOR=C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql_config_editor.exe"
set "MYSQL=C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe"
if not exist "%EDITOR%" (
  echo MySQL Config Editor was not found.
  pause
  exit /b 1
)
echo Enter the MySQL root password at the prompt below.Shanca@772986
echo It will be saved in MySQL's local login-path file for one-time setup.
echo BillMitra will remove this temporary login path after setup.
echo Do not send the password in chat.
"%EDITOR%" set --login-path=billmitra-setup --host=
if errorlevel 1 (
  echo MySQL login setup failed.
  pause
  exit /b 1
)
"%MYSQL%" --login-path=billmitra-setup --protocol=tcp --port=3306 --batch --skip-column-names --execute="SELECT VERSION()"
if errorlevel 1 (
  echo The password was not accepted. Run this helper again to correct it.Shanca@772986
  pause
  exit /b 1

)
echo Local MySQL setup access is ready. Tell Codex: authorized.
pause

