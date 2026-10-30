#!/usr/bin/env python3
"""极简发信（QQ 邮箱 SMTP）

为什么用 Python 而不是 nodemailer：
    内核的 npm 依赖只有 4 个（js-yaml/qrcode/undici/ws）。
    为发几封验证码邮件引入一整个邮件库不值得，
    而 Python 的 smtplib 是标准库，服务器上本来就有。

用法（凭据走环境变量，不进命令行参数）：
    QQ_MAIL_USER=xxx@qq.com QQ_MAIL_CODE=xxx \
    python3 send_mail.py <收件人> <主题> <正文文件>

输出：成功打印 OK，失败打印 ERR: <原因>
"""
import os, sys, smtplib
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr

def main():
    if len(sys.argv) < 4:
        print('ERR: 参数不足（收件人 主题 正文文件）')
        return 2
    to_addr, subject, body_file = sys.argv[1], sys.argv[2], sys.argv[3]

    user = os.environ.get('QQ_MAIL_USER', '').strip()
    code = os.environ.get('QQ_MAIL_CODE', '').strip()
    if not user or not code:
        print('ERR: 缺少 QQ_MAIL_USER / QQ_MAIL_CODE')
        return 2
    if '@' not in to_addr:
        print('ERR: 收件人地址不合法')
        return 2

    try:
        with open(body_file, 'r', encoding='utf-8') as f:
            body = f.read()
    except Exception as e:
        print('ERR: 读正文失败 %s' % e)
        return 2

    msg = MIMEText(body, 'plain', 'utf-8')
    msg['Subject'] = Header(subject, 'utf-8')
    msg['From'] = formataddr((str(Header('鲸界Bridge 创造营', 'utf-8')), user))
    msg['To'] = to_addr

    try:
        s = smtplib.SMTP_SSL('smtp.qq.com', 465, timeout=25)
        s.login(user, code)
        s.sendmail(user, [to_addr], msg.as_string())
        s.quit()
        print('OK')
        return 0
    except smtplib.SMTPAuthenticationError:
        print('ERR: SMTP 认证失败（授权码可能已失效）')
        return 3
    except Exception as e:
        print('ERR: %s: %s' % (type(e).__name__, str(e)[:150]))
        return 4

if __name__ == '__main__':
    sys.exit(main())
