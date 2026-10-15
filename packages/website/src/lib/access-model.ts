// The console's IAM surfaces all ask this one question, so a test can stand up
// an `iam` region by mocking this module alone; the answer is the shared
// region table.
export { supportsIamMethods } from '@filone/shared';
