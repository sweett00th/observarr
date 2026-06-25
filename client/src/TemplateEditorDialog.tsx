import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";

type TemplateVariable = {
  name: string;
  label: string;
  description: string;
  example: string;
};

export type TemplateCatalogEvent = {
  source: string;
  sourceLabel: string;
  eventType: string;
  label: string;
  description: string;
  defaultSmsTemplate: string;
  defaultEmailSubjectTemplate: string;
  defaultEmailBodyTemplate: string;
  variables: TemplateVariable[];
  sampleContext: Record<string, string>;
  template: {
    id: number;
    revision: number;
    hasSmsTemplate: boolean;
    hasEmailSubjectTemplate: boolean;
    hasEmailBodyTemplate: boolean;
    updatedAt: string;
  } | null;
};

type EventTemplateRecord = {
  id: number;
  source: string;
  eventType: string;
  smsBodyTemplate: string | null;
  emailSubjectTemplate: string | null;
  emailBodyTemplate: string | null;
  revision: number;
};

type PreviewState = {
  sms?: { ok: boolean; rendered?: string; errors?: string[]; missingVariables?: string[] };
  emailSubject?: { ok: boolean; rendered?: string; errors?: string[]; missingVariables?: string[] };
  emailBody?: { ok: boolean; rendered?: string; errors?: string[]; missingVariables?: string[] };
};

export function TemplateEditorDialog({
  open,
  catalogEvent,
  onClose,
  onSaved,
}: {
  open: boolean;
  catalogEvent: TemplateCatalogEvent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [template, setTemplate] = useState<EventTemplateRecord | null>(null);
  const [smsBody, setSmsBody] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [focusedField, setFocusedField] = useState<"sms" | "subject" | "body">("sms");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [tab, setTab] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !catalogEvent) return;
    setError(null);
    fetch(`/api/event-templates/${catalogEvent.source}/${catalogEvent.eventType}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || "Could not load template");
        setTemplate(data.template);
        setSmsBody(data.template.smsBodyTemplate ?? "");
        setEmailSubject(data.template.emailSubjectTemplate ?? "");
        setEmailBody(data.template.emailBodyTemplate ?? "");
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Could not load template")
      );
  }, [open, catalogEvent]);

  useEffect(() => {
    if (!open || !catalogEvent) return;
    const timeout = window.setTimeout(updatePreview, 200);
    return () => window.clearTimeout(timeout);
  }, [smsBody, emailSubject, emailBody, open, catalogEvent]);

  if (!catalogEvent) return null;

  async function updatePreview() {
    if (!catalogEvent) return;
    try {
      const response = await fetch(
        `/api/event-templates/${catalogEvent.source}/${catalogEvent.eventType}/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            smsBodyTemplate: smsBody,
            emailSubjectTemplate: emailSubject,
            emailBodyTemplate: emailBody,
          }),
        },
      );
      const data = await response.json();
      if (response.ok) setPreview(data.preview);
    } catch {
      // Preview errors are shown on save; keep editing responsive.
    }
  }

  function insertToken(name: string) {
    const token = `{${name}}`;
    if (focusedField === "subject") setEmailSubject((value) => `${value}${token}`);
    else if (focusedField === "body") setEmailBody((value) => `${value}${token}`);
    else setSmsBody((value) => `${value}${token}`);
  }

  async function saveTemplate() {
    if (!catalogEvent) return;
    const currentEvent = catalogEvent;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/event-templates/${currentEvent.source}/${currentEvent.eventType}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            smsBodyTemplate: smsBody,
            emailSubjectTemplate: emailSubject,
            emailBodyTemplate: emailBody,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.errors?.join(" ") || data.error || "Could not save template");
      }
      setTemplate(data.template);
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save template");
    } finally {
      setSaving(false);
    }
  }

  async function resetTemplate() {
    if (!catalogEvent) return;
    const currentEvent = catalogEvent;
    if (!window.confirm("Reset this global template to the catalog default?")) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/event-templates/${currentEvent.source}/${currentEvent.eventType}/reset`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not reset template");
      setTemplate(data.template);
      setSmsBody(data.template.smsBodyTemplate ?? "");
      setEmailSubject(data.template.emailSubjectTemplate ?? "");
      setEmailBody(data.template.emailBodyTemplate ?? "");
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reset template");
    } finally {
      setSaving(false);
    }
  }

  const smsSegments = Math.max(1, Math.ceil(smsBody.length / 160));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Edit Global Template</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6">{catalogEvent.sourceLabel} - {catalogEvent.label}</Typography>
            <Typography color="text.secondary">{catalogEvent.description}</Typography>
            <Alert severity="warning" sx={{ mt: 2 }}>
              Global template - changes affect every profile subscribed to this event.
            </Alert>
          </Box>

          {error && <Alert severity="error">{error}</Alert>}

          <Box>
            <Typography variant="subtitle2" gutterBottom>Variables</Typography>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              {catalogEvent.variables.map((variable) => (
                <Chip
                  key={variable.name}
                  label={`{${variable.name}}`}
                  onClick={() => insertToken(variable.name)}
                  title={`${variable.description} Example: ${variable.example}`}
                  variant="outlined"
                />
              ))}
            </Stack>
          </Box>

          <TextField
            label="SMS template"
            value={smsBody}
            onFocus={() => setFocusedField("sms")}
            onChange={(event) => setSmsBody(event.target.value)}
            helperText={`${smsBody.length} characters. Roughly ${smsSegments} SMS segment(s); carrier segmentation can vary.`}
            multiline
            minRows={3}
            fullWidth
          />

          <Alert severity="info">
            Email templates are saved now, but email delivery is not configured yet.
          </Alert>
          <TextField
            label="Email subject template"
            value={emailSubject}
            onFocus={() => setFocusedField("subject")}
            onChange={(event) => setEmailSubject(event.target.value)}
            fullWidth
          />
          <TextField
            label="Email body template"
            value={emailBody}
            onFocus={() => setFocusedField("body")}
            onChange={(event) => setEmailBody(event.target.value)}
            multiline
            minRows={5}
            fullWidth
          />

          <Box>
            <Tabs value={tab} onChange={(_, next) => setTab(next)}>
              <Tab label="SMS Preview" />
              <Tab label="Email Preview" />
            </Tabs>
            <Divider sx={{ mb: 2 }} />
            {tab === 0 ? <PreviewBlock result={preview?.sms} /> : (
              <Stack spacing={2}>
                <Typography variant="subtitle2">Subject</Typography>
                <PreviewBlock result={preview?.emailSubject} />
                <Typography variant="subtitle2">Body</Typography>
                <PreviewBlock result={preview?.emailBody} />
              </Stack>
            )}
          </Box>

          {template && (
            <Typography variant="caption" color="text.secondary">
              Current revision: {template.revision}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={resetTemplate} disabled={saving}>Reset to Default</Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={saveTemplate} disabled={saving}>
          {saving ? "Saving" : "Save Template"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PreviewBlock(
  { result }: {
    result?: { ok: boolean; rendered?: string; errors?: string[]; missingVariables?: string[] };
  },
) {
  if (!result) return <Typography color="text.secondary">Preview unavailable.</Typography>;
  if (!result.ok) {
    return (
      <Alert severity="error">
        {[...(result.errors ?? []), ...(result.missingVariables ?? [])].join("; ")}
      </Alert>
    );
  }
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 2,
        bgcolor: "grey.100",
        borderRadius: 1,
        whiteSpace: "pre-wrap",
        fontFamily: "monospace",
      }}
    >
      {result.rendered}
    </Box>
  );
}
