id: login-lockout
tags: auth, security

Ann ("ann@example.com", password "secret1") enters the wrong password "nope" 3 times in a row.
After the third attempt her account is locked and the page says "Account locked".
Even the right password does not get her in after that.

```checks
C1 after the third wrong password the message is "Account locked"
C2 signing in with the right password still says "Account locked"
```
