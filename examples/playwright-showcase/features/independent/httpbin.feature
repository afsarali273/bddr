@api @independent @owner:framework
Feature: Independent HTTP API checks
  These API scenarios intentionally have no named group and use httpbin independently of the main API targets.

  Background:
    Given the independent HTTP API base URL is configured

  @id:independent-api-json
  Scenario: HTTPBin returns a JSON document
    When I GET independent API path "/json"
    Then the API response status is 200
    And the independent API field path "slideshow.title" equals "Sample Slide Show"

  @id:independent-api-anything
  Scenario: HTTPBin echoes request metadata
    When I GET independent API path "/anything?source=bddr"
    Then the API response status is 200
    And the independent API field path "args.source" equals "bddr"

  @id:independent-api-status
  Scenario: HTTPBin exposes explicit status responses
    When I GET independent API path "/status/418"
    Then the API response status is 418
