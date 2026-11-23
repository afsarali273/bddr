id: login-wrong-password
tags: auth

Ann ("ann@example.com", password "secret1") tries to sign in with the password "nope".
She must see the generic message "Invalid email or password", which does not reveal whether the email exists,
and she must not be signed in.

```checks
C1 the message is exactly "Invalid email or password"
C2 the "Welcome, Ann" heading is not shown
```
