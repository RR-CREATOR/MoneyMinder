const mindee = require("mindee");
const express = require("express");
const multer = require("multer"); // Middleware for handling file uploads
const upload = multer(); // Create an instance of multer
const app = express();
const cors = require("cors");
const path = require("path"); // For handling file paths
const port = 3000;

app.use(cors());
app.use(express.json());

// Serve login.html explicitly for root URL
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Serve other static files
app.use(express.static(path.join(__dirname, "public")));

// Initialize Mindee client
const mindeeClient = new mindee.Client({ apiKey: "4c7fa29daf125f917b86a0fc8fe1bb0c" });

// Endpoint to parse receipt
app.post("/parse-receipt", upload.single("input"), async (req, res) => {
    try {
        console.log("Received a POST request at /parse-receipt");

        // Log the contents of the request body (for debugging purposes)
        console.log("Request body:", req.body);

        // Log the file data 
        console.log("File data:", req.file);

        const fileData = req.file.buffer; // Get the file data from the request

        // Log the length of the file data (for debugging purposes)
        console.log("File data length:", fileData.length);
        const inputSource = mindeeClient.docFromBuffer(fileData, req.file.originalname);
        const apiResponse = mindeeClient.parse(
            mindee.product.ReceiptV5,
            inputSource
        );
        apiResponse.then((resp) => {
            // Print a string summary
            var array = [
                resp.document.inference.prediction.category.value.toString(),
                resp.document.inference.prediction.date.value.toString(),
                resp.document.inference.prediction.totalAmount.value.toString(),
                resp.document.inference.prediction.supplierName.value,
                resp.document.inference.prediction.documentType.value
            ];
            console.log("Array:", array); 
            console.log(resp.document.toString());
            res.send(array); // Send the array as a response to the client
        });
    } catch (error) {
        console.error("An error occurred:", error);
        res.status(500).json({ error: "An error occurred" });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
