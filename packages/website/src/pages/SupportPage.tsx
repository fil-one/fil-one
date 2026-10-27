import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DOCS_URL } from '@filone/shared';

import { PageLayout } from '../components/PageLayout.js';
import { Accordion, type AccordionItem } from '../components/Accordion';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { FormField } from '../components/FormField';
import { Heading } from '../components/Heading/Heading';
import { InfoAside } from '../components/InfoAside';
import { Input } from '../components/Input';
import { Link } from '../components/Link';
import { RadioOption } from '../components/RadioOption';
import { ReportBugDialog } from '../components/ReportBugDialog';
import { Textarea } from '../components/TextArea';
import { useToast } from '../components/Toast';
import { getMe } from '../lib/api.js';
import { submitSupportForm } from '../lib/hubspot.js';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS = [
  { label: 'Product issue', value: 'PRODUCT_ISSUE' },
  { label: 'Billing issue', value: 'BILLING_ISSUE' },
  { label: 'General inquiry', value: 'GENERAL_INQUIRY' },
  { label: 'Feature request', value: 'FEATURE_REQUEST' },
] as const;

const FAQ_ITEMS: AccordionItem[] = [
  {
    title: 'Can I make a bucket public?',
    content:
      'Public buckets are not currently supported. To share individual files, you can generate a presigned URL from the dashboard or via the S3 API. This gives time-limited access to a specific object without making the entire bucket public.',
  },
  {
    title: 'Are there any hidden fees on top of the storage price?',
    content:
      'No. Fil One charges a flat rate per TB stored per month with no egress penalties, no API request charges, and no retrieval penalties. What you see is what you pay.',
  },
  {
    title: 'How do I migrate from Storacha or another S3-compatible provider?',
    content:
      "Fil One is S3-compatible, so tools like rclone work out of the box. Point rclone at s3.eu-west-1.filonecontent.com with your Fil One credentials and sync your data across. If you need help with a larger migration, reach out and we'll guide you through it.",
  },
  {
    title: 'Can I pay with FIL tokens?',
    content:
      'Not currently. Billing is in USD. If paying in FIL is a hard requirement, get in touch and we can explore options depending on your storage volume.',
  },
];

interface SupportFormErrors {
  email?: string;
  category?: string;
  message?: string;
}

/** What is missing from the form, by field. Empty when it can be sent. */
function getSupportFormErrors(fields: {
  needsEmail: boolean;
  email: string;
  category: string;
  message: string;
}): SupportFormErrors {
  const errors: SupportFormErrors = {};
  if (fields.needsEmail && !fields.email.trim()) errors.email = 'Enter an email address.';
  else if (fields.needsEmail && !fields.email.includes('@'))
    errors.email = 'Enter a valid email address.';
  if (!fields.category) errors.category = 'Choose a category.';
  if (!fields.message.trim()) errors.message = 'Tell us how we can help.';
  return errors;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SupportPage() {
  const { toast } = useToast();
  // Who is asking comes from the signed-in profile rather than the form. The
  // email field appears only for an account whose sign-in method gave no
  // address, so there is still somewhere to reply.
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });
  const needsEmail = me !== undefined && !me.email;

  // Contact form state
  const [formEmail, setFormEmail] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [errors, setErrors] = useState<SupportFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [reportBugOpen, setReportBugOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !me) return;
    const nextErrors = getSupportFormErrors({
      needsEmail,
      email: formEmail,
      category: formCategory,
      message: formMessage,
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    try {
      await submitSupportForm({
        name: me.name,
        organization: me.orgName,
        email: me.email || formEmail.trim(),
        categories: [formCategory],
        message: formMessage.trim(),
      });
      setFormEmail('');
      setFormCategory('');
      setFormMessage('');
      toast.success("Message sent! We'll get back to you within 1 business day.");
    } catch {
      toast.error('Failed to send message. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageLayout
      title="Support"
      headingId="support-heading"
      // Centered like Create bucket. The side padding drops at xl, where the page is wider
      // than the column, so the form and help column get the full 860px.
      maxWidth="max-w-[860px]"
      className="xl:px-0"
      description="We typically respond within 1 business day"
    >
      {/* Two columns once both fit beside the app sidebar; stacked below that, as on Create bucket */}
      <div className="flex flex-col gap-6 pb-12 xl:flex-row xl:gap-10">
        <div className="flex w-full max-w-[520px] shrink-0 flex-col gap-8">
          <Card>
            {/* noValidate: the browser's own bubbles do not match the console,
                so each field shows its error under itself instead. */}
            <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
              {needsEmail && (
                <FormField label="Email" htmlFor="support-email" error={errors.email}>
                  <Input
                    id="support-email"
                    type="email"
                    value={formEmail}
                    invalid={!!errors.email}
                    onChange={(value) => {
                      setFormEmail(value);
                      setErrors((current) => ({ ...current, email: undefined }));
                    }}
                    placeholder="you@example.com"
                  />
                </FormField>
              )}

              <FormField label="Category" error={errors.category}>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CATEGORY_OPTIONS.map((option) => (
                    <RadioOption
                      key={option.value}
                      name="category"
                      value={option.value}
                      checked={formCategory === option.value}
                      onChange={() => {
                        setFormCategory(option.value);
                        setErrors((current) => ({ ...current, category: undefined }));
                      }}
                    >
                      {option.label}
                    </RadioOption>
                  ))}
                </div>
              </FormField>

              <FormField label="Message" htmlFor="support-message" error={errors.message}>
                <Textarea
                  id="support-message"
                  value={formMessage}
                  invalid={!!errors.message}
                  onChange={(value) => {
                    setFormMessage(value);
                    setErrors((current) => ({ ...current, message: undefined }));
                  }}
                  placeholder="How can we help?"
                  rows={4}
                />
              </FormField>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {me?.email && (
                  <p className="min-w-0 text-xs break-words text-(--color-paragraph-text-subtle)">
                    We&apos;ll reply to{' '}
                    <span className="font-medium text-(--color-paragraph-text)">{me.email}</span>
                  </p>
                )}
                {/* ml-auto keeps the button on the right when there is no reply line */}
                <Button
                  className="sm:ml-auto"
                  id="support-submit-button"
                  variant="primary"
                  type="submit"
                  disabled={!me}
                  loading={submitting}
                  loadingLabel="Sending message"
                >
                  Send message
                </Button>
              </div>
            </form>
          </Card>

          <section aria-labelledby="support-faq-heading">
            <Heading tag="h2" size="sm" id="support-faq-heading" className="mb-3">
              Common questions
            </Heading>
            <Accordion items={FAQ_ITEMS} />
          </section>
        </div>

        <InfoAside
          title="More help"
          items={[
            {
              title: 'Documentation',
              description: (
                <>
                  Guides for buckets, API keys, and S3 clients.{' '}
                  <Link href={DOCS_URL} variant="accent">
                    Read the docs
                  </Link>
                </>
              ),
            },
            {
              title: 'Found a bug?',
              description: (
                <>
                  Tell us what went wrong and we&apos;ll look into it.{' '}
                  <button
                    type="button"
                    onClick={() => setReportBugOpen(true)}
                    className="font-medium text-brand-600 hover:underline focus-visible:brand-outline"
                  >
                    Report a bug
                  </button>
                </>
              ),
            },
          ]}
        />
      </div>
      <ReportBugDialog open={reportBugOpen} onClose={() => setReportBugOpen(false)} />
    </PageLayout>
  );
}
