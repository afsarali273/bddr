Feature: B
  @id:setup
  Scenario: second
    Given a passing step
  @dependsOn:setup
  Scenario: third
    Given a passing step
