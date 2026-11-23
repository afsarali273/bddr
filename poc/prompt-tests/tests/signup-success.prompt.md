id: signup-success
tags: smoke, auth

Bo signs up with the name "Bo", the email "bo@example.com" and the password "hunter22".
He lands on his account page greeted with "Welcome, Bo", and an account exists for that email.

```checks
C1 the heading "Welcome, Bo" is shown
C2 an account named "Bo" exists for "bo@example.com"
```
