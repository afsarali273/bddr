@ui @the-internet @owner:web
Feature: UI navigation and status pages
  Playwright drives public pages while bddr owns discovery, orchestration, hooks and reporting.

  Background:
    Given the UI base URL is configured

  @id:ui-home @dependsOn:health-ui @smoke @capture
  Scenario: Home page introduces the example application
    Given health check "health-ui" exported status 200
    When I open UI path "/"
    Then the page heading is "Welcome to the-internet"
    And the page has at least 70 example links

  @id:ui-example-navigation
  Scenario Outline: Named examples navigate to their expected route
    When I open UI path "/"
    And I follow the example link "<label>"
    Then the current UI path is "<path>"

    Examples:
      | label               | path                  |
      | Add/Remove Elements | /add_remove_elements  |
      | Checkboxes          | /checkboxes            |
      | Dropdown            | /dropdown              |
      | Inputs              | /inputs                |
      | JavaScript Alerts   | /javascript_alerts     |

  @id:ui-status-code
  Scenario Outline: Status code examples explain the selected response
    When I open UI path "/status_codes/<code>"
    Then the response status is <code>
    And the page content mentions status code <code>

    Examples:
      | code |
      | 200  |
      | 301  |
      | 404  |
      | 500  |

  @id:ui-redirect
  Scenario: Redirect link lands on the status code catalogue
    When I open UI path "/redirector"
    And I follow the redirect link
    Then the current UI path is "/status_codes"
