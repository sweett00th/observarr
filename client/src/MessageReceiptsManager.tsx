import SearchIcon from "@mui/icons-material/Search";
import {
  Alert,
  Box,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Grid,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";

type MessageReceipt = {
  id: number;
  eventSource: string | null;
  eventType: string | null;
  eventTitle: string | null;
  profileName: string | null;
  channel: string;
  provider: string | null;
  templateRevision: number | null;
  renderedBody: string | null;
  renderContext: unknown;
  destinationMasked: string | null;
  providerMessageId: string | null;
  submissionStatus: string;
  deliveryStatus: string;
  providerError: string | null;
  providerResponse: unknown;
  quotaRemaining: number | null;
  attemptedAt: string;
  submittedAt: string | null;
  lastStatusCheckAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export function MessageReceiptsManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [receipts, setReceipts] = useState<MessageReceipt[]>([]);
  const [selected, setSelected] = useState<MessageReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchReceipts();
  }, [open, query]);

  async function fetchReceipts() {
    try {
      const response = await fetch(
        `/api/message-receipts?query=${encodeURIComponent(query)}&limit=100`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load receipts");
      setReceipts(data.receipts);
      if (!selected && data.receipts[0]) setSelected(data.receipts[0]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load receipts");
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>Message Receipts</DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={3} sx={{ minHeight: 620 }}>
          <Grid item xs={12} md={5}>
            <Stack spacing={2}>
              <TextField
                size="small"
                label="Search receipts"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
              {error && <Alert severity="error">{error}</Alert>}
              <List dense sx={{ maxHeight: 540, overflowY: "auto" }}>
                {receipts.map((receipt) => (
                  <ListItemButton
                    key={receipt.id}
                    selected={selected?.id === receipt.id}
                    onClick={() => setSelected(receipt)}
                    sx={{ borderRadius: 1, mb: 0.5 }}
                  >
                    <ListItemText
                      primary={receipt.eventTitle ?? `${receipt.eventSource}:${receipt.eventType}`}
                      secondary={
                        <Stack spacing={0.75} sx={{ mt: 0.5 }}>
                          <Typography variant="caption" color="text.secondary">
                            {new Date(receipt.createdAt).toLocaleString()} -{" "}
                            {receipt.profileName ?? "Unknown profile"} -{" "}
                            {receipt.destinationMasked ?? "masked"}
                          </Typography>
                          <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.5 }}>
                            <Chip size="small" label={receipt.channel} />
                            <Chip size="small" label={receipt.provider ?? "provider"} />
                            <Chip
                              size="small"
                              label={receipt.submissionStatus}
                              color={receipt.submissionStatus === "submitted"
                                ? "success"
                                : receipt.submissionStatus.includes("failed") ||
                                    receipt.submissionStatus === "rejected"
                                ? "error"
                                : "default"}
                            />
                            <Chip size="small" label={receipt.deliveryStatus} variant="outlined" />
                          </Stack>
                        </Stack>
                      }
                    />
                  </ListItemButton>
                ))}
              </List>
            </Stack>
          </Grid>
          <Grid item xs={12} md={7}>
            {selected
              ? <ReceiptDetails receipt={selected} />
              : <Alert severity="info">Select a receipt.</Alert>}
          </Grid>
        </Grid>
      </DialogContent>
    </Dialog>
  );
}

function ReceiptDetails({ receipt }: { receipt: MessageReceipt }) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">{receipt.eventTitle ?? "Message receipt"}</Typography>
        <Typography color="text.secondary">{receipt.eventSource} - {receipt.eventType}</Typography>
      </Box>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Chip label={`Submission: ${receipt.submissionStatus}`} />
        <Chip label={`Delivery: ${receipt.deliveryStatus}`} />
        <Chip label={`Provider: ${receipt.provider ?? "n/a"}`} />
        {receipt.quotaRemaining !== null && <Chip label={`Quota: ${receipt.quotaRemaining}`} />}
      </Stack>
      {receipt.providerError && <Alert severity="error">{receipt.providerError}</Alert>}
      <Typography variant="subtitle2">Rendered message</Typography>
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
        {receipt.renderedBody ?? "No rendered body stored."}
      </Box>
      <Typography variant="subtitle2">Metadata</Typography>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 2,
          bgcolor: "grey.100",
          borderRadius: 1,
          whiteSpace: "pre-wrap",
          fontFamily: "monospace",
          maxHeight: 220,
          overflow: "auto",
        }}
      >
        {JSON.stringify(
          {
            profile: receipt.profileName,
            destination: receipt.destinationMasked,
            templateRevision: receipt.templateRevision,
            textbeltMessageId: receipt.providerMessageId,
            attemptedAt: receipt.attemptedAt,
            submittedAt: receipt.submittedAt,
            lastStatusCheckAt: receipt.lastStatusCheckAt,
            deliveredAt: receipt.deliveredAt,
            renderContext: receipt.renderContext,
            providerResponse: receipt.providerResponse,
          },
          null,
          2,
        )}
      </Box>
    </Stack>
  );
}
