import { useState } from 'react';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { FormField } from '../components/FormField';
import { Input } from '../components/Input';
import { RadioOption } from '../components/RadioOption';
import { Textarea } from '../components/TextArea';
import { useToast } from '../components/Toast';
import { submitSupportForm } from '../lib/hubspot.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS = [
  { label: 'Product Issue', value: 'PRODUCT_ISSUE' },
  { label: 'Billing Issue', value: 'BILLING_ISSUE' },
  { label: 'General Inquiry', value: 'GENERAL_INQUIRY' },
  { label: 'Feature Request', value: 'FEATURE_REQUEST' },
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SupportPage() {
  const { toast } = useToast();

  // Contact form state
  const [formFirstName, setFormFirstName] = useState('');
  const [formLastName, setFormLastName] = useState('');
  const [formCompany, setFormCompany] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!formCategory) {
      toast.error('Please select a category.');
      return;
    }
    setSubmitting(true);
    try {
      await submitSupportForm({
        firstName: formFirstName.trim(),
        lastName: formLastName.trim(),
        company: formCompany.trim(),
        email: formEmail.trim(),
        categories: [formCategory],
        message: formMessage.trim(),
      });
      setFormFirstName('');
      setFormLastName('');
      setFormCompany('');
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
    <div className="px-10 pt-10">
      <Heading tag="h1" size="xl" description="We typically respond within 1 business day">
        Talk to an expert
      </Heading>

      <div className="max-w-xl mt-8">
        <Card padding="none">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="First name">
                <Input
                  value={formFirstName}
                  onChange={setFormFirstName}
                  placeholder="Jane"
                  required
                />
              </FormField>

              <FormField label="Last name">
                <Input
                  value={formLastName}
                  onChange={setFormLastName}
                  placeholder="Smith"
                  required
                />
              </FormField>
            </div>

            <FormField label="Company name">
              <Input
                value={formCompany}
                onChange={setFormCompany}
                placeholder="Acme Inc."
                required
              />
            </FormField>

            <FormField label="Email">
              <Input
                type="email"
                value={formEmail}
                onChange={setFormEmail}
                placeholder="you@example.com"
                required
              />
            </FormField>

            <FormField label="Category">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {CATEGORY_OPTIONS.map((option) => (
                  <RadioOption
                    key={option.value}
                    name="category"
                    value={option.value}
                    checked={formCategory === option.value}
                    onChange={() => setFormCategory(option.value)}
                  >
                    {option.label}
                  </RadioOption>
                ))}
              </div>
            </FormField>

            <FormField label="Message">
              <Textarea
                value={formMessage}
                onChange={setFormMessage}
                placeholder="How can we help?"
                required
                rows={4}
              />
            </FormField>

            <div className="flex justify-end">
              <Button variant="primary" type="submit" disabled={submitting}>
                {submitting ? 'Sending...' : 'Send message'}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
