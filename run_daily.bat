@echo off
cd /d "C:\Users\sktl50462\Documents\크롤링\ktm-crawler"

REM 이메일 설정 로드
call email_config.bat

echo [%date% %time%] === 일간 크롤링 시작 === >> logs\daily.log 2>&1
"C:\Program Files\nodejs\npm.cmd" run daily >> logs\daily.log 2>&1
echo [%date% %time%] 종료코드: %errorlevel% >> logs\daily.log 2>&1
echo [%date% %time%] === 완료 === >> logs\daily.log 2>&1
