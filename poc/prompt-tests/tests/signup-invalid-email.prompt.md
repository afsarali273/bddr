id: signup-invalid-email
tags: auth

Someone tries to create an account named "Bo" with the email "not-an-email".
The form must refuse it with "Enter a valid email", and no account may exist for that email afterwards.

```checks
C1 the message "Enter a valid email" is shown
C2 no account exists for "not-an-email"
```
