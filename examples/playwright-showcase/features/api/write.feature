@api @jsonplaceholder @owner:services
Feature: JSONPlaceholder simulated write operations
  JSONPlaceholder returns realistic write responses without persisting shared state.

  Background:
    Given the API base URL is configured

  Rule: Resources can be created and replaced

    @id:api-create-post
    Scenario Outline: Create a post
      When I POST API path "/posts" with values:
        | title  | body   | userId  |
        | <title> | <body> | <userId> |
      Then the API response status is 201
      And the API field "id" equals 101
      And the API field "userId" equals <userId>
      And the API field "title" equals "<title>"

      Examples:
        | title       | body              | userId |
        | bddr alpha  | created by bddr   | 1      |
        | bddr beta   | driven by features| 5      |
        | bddr gamma  | sent by Playwright| 10     |

    @id:api-replace-post
    Scenario Outline: Replace a post
      When I PUT API path "/posts/<id>" with JSON:
        """
        {"id": <id>, "title": "<title>", "body": "replacement", "userId": <userId>}
        """
      Then the API response status is 200
      And the API field "id" equals <id>
      And the API field "userId" equals <userId>
      And the API field "title" equals "<title>"

      Examples:
        | id | title          | userId |
        | 1  | replaced one   | 1      |
        | 50 | replaced fifty | 5      |

  Rule: Resources can be patched and deleted

    @id:api-patch-post
    Scenario Outline: Patch a post title
      When I PATCH API path "/posts/<id>" with title "<title>"
      Then the API response status is 200
      And the API field "id" equals <id>
      And the API field "title" equals "<title>"

      Examples:
        | id  | title          |
        | 2   | patched two    |
        | 55  | patched fifty  |
        | 100 | patched hundred|

    @id:api-delete-post
    Scenario Outline: Delete a post
      When I DELETE API path "/posts/<id>"
      Then the API response status is 200
      And the API response is an empty object

      Examples:
        | id |
        | 1  |
        | 50 |
        | 100|

  Rule: Missing resources are reported

    @id:api-missing-post
    Scenario: Unknown post returns not found
      When I GET API path "/posts/999999"
      Then the API response status is 404
      And the API response is an empty object
