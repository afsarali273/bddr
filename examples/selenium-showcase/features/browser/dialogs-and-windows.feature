@ui @the-internet @browser @owner:web
Feature: Browser dialogs, windows and sessions

  Rule: JavaScript dialogs

    Scenario: An alert can be accepted
      Given I open "/javascript_alerts"
      When I trigger the JS alert
      And I accept the dialog
      Then the dialog result says "You successfully clicked an alert"

    Scenario: A confirm can be dismissed
      Given I open "/javascript_alerts"
      When I trigger the JS confirm
      And I dismiss the dialog
      Then the dialog result says "You clicked: Cancel"

    Scenario: A prompt returns the typed text
      Given I open "/javascript_alerts"
      When I trigger the JS prompt
      And I type "bddr" into the prompt and accept
      Then the dialog result says "You entered: bddr"

  Rule: Windows and sessions

    Scenario: A link opens a second window
      Given I open "/windows"
      When I open the link that opens a new window
      Then a second window opens with heading "New Window"

    Scenario: A second browser session does not share the login
      Given user "tomsmith" is logged in
      When a second browser session opens the secure area
      Then the second session was sent to the login page
      And the first session is still on the secure area
