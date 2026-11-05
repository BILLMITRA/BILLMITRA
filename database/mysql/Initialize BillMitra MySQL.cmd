@echo off
setlocal
set "MYSQL_EXE=C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe"
if not exist "%MYSQL_EXE%" (
  echo MySQL 8.4 client was not found.
  echo Expected: %MYSQL_EXE%
  pause
  exit /b 1
)
echo This creates the empty BillMitra central database on this PC.
echo MySQL will request your root password privately. It will not be saved here.
echo.
"%MYSQL_EXE%" --protocol=tcp --host=127.0.0.1 --port=3306 --user=root -p --execute="CREATE DATABASE IF NOT EXISTS billmitra CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
if errorlevel 1 (
  echo Database creation failed. No BillMitra schema was imported.
  pause
  exit /b 1
)
echo.
echo Enter the root password again to import the BillMitra schema.
"%MYSQL_EXE%" --protocol=tcp --host=127.0.0.1 --port=3306 --user=root -p --database=billmitra --show-warnings < "%~dp0001_initial.sql"
if errorlevel 1 (
  echo Schema import failed. Do not run this file again until the error is checked.
  pause
  exit /b 1
)
echo.
echo BillMitra MySQL schema imported. The application has not been switched to MySQL yet.
pause
