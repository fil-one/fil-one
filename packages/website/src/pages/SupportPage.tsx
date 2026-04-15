import { useState } from 'react';

import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { TextArea } from '../components/TextArea';
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
  const [formCategories, setFormCategories] = useState<string[]>([]);
  const [formMessage, setFormMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function toggleCategory(value: string) {
    setFormCategories((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (formCategories.length === 0) {
      toast.error('Please select at least one category.');
      return;
    }
    setSubmitting(true);
    try {
      await submitSupportForm({
        firstName: formFirstName.trim(),
        lastName: formLastName.trim(),
        company: formCompany.trim(),
        email: formEmail.trim(),
        categories: formCategories,
        message: formMessage.trim(),
      });
      setFormFirstName('');
      setFormLastName('');
      setFormCompany('');
      setFormEmail('');
      setFormCategories([]);
      setFormMessage('');
      toast.success("Message sent! We'll get back to you within 1 business day.");
    } catch {
      toast.error('Failed to send message. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-zinc-900 mb-6">Talk to an Expert</h1>
      <p className="text-sm text-zinc-600 mb-6">We typically respond within 1 business day.</p>

      <div className="max-w-xl">
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-zinc-700">First name</label>
                <Input
                  value={formFirstName}
                  onChange={setFormFirstName}
                  placeholder="Jane"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-zinc-700">Last name</label>
                <Input
                  value={formLastName}
                  onChange={setFormLastName}
                  placeholder="Smith"
                  required
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">Company name</label>
              <Input
                value={formCompany}
                onChange={setFormCompany}
                placeholder="Acme Inc."
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">Email</label>
              <Input
                type="email"
                value={formEmail}
                onChange={setFormEmail}
                placeholder="you@example.com"
                required
              />
            </div>

            {/* Category multi-select */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">Category</label>
              <div className="flex flex-wrap gap-2">
                {CATEGORY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleCategory(option.value)}
                    className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                      formCategories.includes(option.value)
                        ? 'bg-brand-600 text-white border-brand-600'
                        : 'bg-white text-zinc-700 border-zinc-300 hover:border-zinc-400'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Message */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">Message</label>
              <TextArea
                value={formMessage}
                onChange={setFormMessage}
                placeholder="How can we help?"
                required
                rows={4}
              />
            </div>

            <div className="flex justify-end">
              <Button variant="filled" type="submit" disabled={submitting}>
                {submitting ? 'Sending...' : 'Send message'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
